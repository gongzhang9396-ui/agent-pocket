// ignore_for_file: avoid_relative_lib_imports, avoid_print
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import '../lib/session/existing_device_login.dart';
import '../lib/session/session_manager.dart';
import 'session_contract_smoke.dart' show MemoryStore;
import 'relay_token_refresh_smoke.dart' show FakeClient, FakeRequest, FakeResponse;

Map<String, dynamic> original() => {
  'endpoint': 'https://example.invalid/root', 'username': 'Admin', 'accountId': 'account',
  'deviceId': 'device', 'deviceName': 'phone', 'deviceStatus': 'approved',
  'deviceSigningPublicKey': 'device-sign', 'deviceSigningPrivateKey': 'device-sign-secret',
  'deviceEncryptionPublicKey': 'device-box', 'deviceEncryptionPrivateKey': 'device-box-secret',
  'accountSigningPublicKey': 'account-sign', 'accountEncryptionPublicKey': 'account-box',
  'accountSigningPrivateKey': 'account-sign-secret', 'accountEncryptionPrivateKey': 'account-box-secret',
  'contentKey': 'content-secret', 'accessToken': 'old', 'refreshToken': 'old-refresh',
  'accessExpiresAt': 100, 'refreshExpiresAt': 200, 'requiresLogin': true,
};
Map<String, dynamic> response({String id = 'device', String status = 'approved', String? package}) => {
  'account': {'id': 'account', 'username': 'admin', 'signingPublicKey': 'account-sign', 'encryptionPublicKey': 'account-box'},
  'device': {'id': id, 'name': 'phone', 'status': status, ...?(package == null ? null : {'keyPackage': package})},
  'tokens': {'accessToken': 'new', 'refreshToken': 'next', 'accessExpiresAt': 1000, 'refreshExpiresAt': 2000},
};
Map<String, dynamic> open(String package, Map<String, dynamic> device, String sign, String box) => {
  'signingPrivateKey': 'new-sign-secret', 'encryptionPrivateKey': 'new-box-secret', 'contentKey': 'new-content',
};

Future<void> main() async {
  final store = MemoryStore(original())..blocked = true;
  final sessions = SessionManager(store, (_) async => throw StateError('unexpected refresh'));
  var requests = 0;
  final login = ExistingDeviceLogin(sessions, open, now: () => 500, request: (uri, body) async {
    requests++;
    assert(uri.toString() == 'https://example.invalid/root/api/auth/login');
    assert(body['deviceId'] == 'device' && body['deviceSigningPublicKey'] == 'device-sign');
    assert(!body.containsValue('device-sign-secret') && !body.containsValue('content-secret'));
    return response();
  });
  final result = await login.login('password');
  assert(requests == 1 && result['deviceId'] == 'device' && result['contentKey'] == 'content-secret');
  assert(result['accessToken'] == 'new' && !store.blocked && store.value!['requiresLogin'] == false);

  final packageStore = MemoryStore(original());
  final packageSession = SessionManager(packageStore, (_) async => {});
  final packageLogin = ExistingDeviceLogin(packageSession, open, now: () => 500,
    request: (_, _) async => response(package: 'sealed'));
  assert((await packageLogin.login('password'))['contentKey'] == 'new-content');

  final mismatchStore = MemoryStore(original())..blocked = true;
  final mismatch = ExistingDeviceLogin(SessionManager(mismatchStore, (_) async => {}), open, now: () => 500,
    request: (_, _) async => response(id: 'other'));
  try { await mismatch.login('password'); throw StateError('different device accepted'); }
  on FormatException { assert(mismatchStore.blocked && mismatchStore.value!['accessToken'] == 'old'); }

  final gate = Completer<Map<String, dynamic>>();
  final staleStore = MemoryStore(original());
  final staleSession = SessionManager(staleStore, (_) async => {});
  final staleLogin = ExistingDeviceLogin(staleSession, open, now: () => 500, request: (_, _) => gate.future);
  final pending = staleLogin.login('password');
  await Future<void>.delayed(Duration.zero);
  await staleSession.clear();
  gate.complete(response());
  try { await pending; throw StateError('old response restored logout'); }
  on SessionChanged { assert(staleStore.value == null); }

  final empty = MemoryStore(null);
  final noDevice = ExistingDeviceLogin(SessionManager(empty, (_) async => {}), open,
    request: (_, _) async { throw StateError('unexpected network request'); });
  try { await noDevice.login('password'); throw StateError('missing identity accepted'); }
  on StateError catch (error) { assert(error.message.toString().contains('没有可恢复')); }

  final httpRequest = FakeRequest(FakeResponse(200, jsonEncode(response())));
  final httpClient = FakeClient(httpRequest);
  final http = RelayLoginHttp(clientFactory: () => httpClient);
  final httpResult = await http(Uri.parse('https://example.invalid/api/auth/login'), {'password': 'secret'});
  assert(!httpRequest.followRedirects && httpRequest.headers.contentType?.mimeType == 'application/json');
  assert(jsonDecode(httpRequest.payload)['password'] == 'secret' && httpResult['device']['id'] == 'device');
  assert(httpClient.closed && !httpClient.url.toString().contains('secret'));
  final redirect = RelayLoginHttp(clientFactory: () => FakeClient(FakeRequest(FakeResponse(302, ''))));
  try { await redirect(Uri.parse('https://example.invalid/api/auth/login'), {}); throw StateError('redirect accepted'); }
  on HttpException { /* Passwords must not follow redirects. */ }
  try { await http(Uri.parse('http://example.invalid/login'), {}); throw StateError('insecure URL accepted'); }
  on FormatException { /* Login only uses HTTPS. */ }
  print('existing device login contract passed');
}
