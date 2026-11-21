// ignore_for_file: avoid_relative_lib_imports, avoid_print
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import '../lib/session/relay_token_refresh.dart';
import '../lib/session/session_manager.dart';

class FakeHeaders implements HttpHeaders {
  @override ContentType? contentType;
  @override dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
class FakeResponse extends Stream<List<int>> implements HttpClientResponse {
  FakeResponse(this.statusCode, this.body);
  @override final int statusCode;
  final String body;
  @override StreamSubscription<List<int>> listen(void Function(List<int>)? onData,
      {Function? onError, void Function()? onDone, bool? cancelOnError}) =>
      Stream<List<int>>.value(utf8.encode(body)).listen(onData, onError: onError, onDone: onDone, cancelOnError: cancelOnError);
  @override dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
class FakeRequest implements HttpClientRequest {
  FakeRequest(this.response);
  final FakeResponse response;
  @override bool followRedirects = true;
  @override final HttpHeaders headers = FakeHeaders();
  String payload = '';
  @override void write(Object? value) { payload += value.toString(); }
  @override Future<HttpClientResponse> close() async => response;
  @override dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
class FakeClient implements HttpClient {
  FakeClient(this.request);
  final FakeRequest request;
  Uri? url;
  bool closed = false;
  @override Duration? connectionTimeout;
  @override Future<HttpClientRequest> postUrl(Uri value) async { url = value; return request; }
  @override void close({bool force = false}) { closed = true; }
  @override dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Future<void> main() async {
  final request = FakeRequest(FakeResponse(200, jsonEncode({
    'accessToken': 'new-access', 'refreshToken': 'new-refresh',
    'accessExpiresAt': 200000, 'refreshExpiresAt': 900000,
  })));
  final client = FakeClient(request);
  final refresh = RelayTokenRefresh(clientFactory: () => client);
  final result = await refresh({'endpoint': 'https://example.invalid/sub/', 'refreshToken': 'secret'});
  assert(client.url.toString() == 'https://example.invalid/sub/api/auth/refresh');
  assert(!request.followRedirects && request.headers.contentType?.mimeType == 'application/json');
  assert(jsonDecode(request.payload)['refreshToken'] == 'secret' && !client.url.toString().contains('secret'));
  assert(result['accessToken'] == 'new-access' && client.closed);

  for (final endpoint in ['http://example.invalid', 'https://u:p@example.invalid', 'https://example.invalid/?q=x']) {
    try { await refresh({'endpoint': endpoint, 'refreshToken': 'secret'}); throw StateError('invalid endpoint accepted'); }
    on RefreshNotSent { /* No network request was created. */ }
  }
  final rejected = RelayTokenRefresh(clientFactory: () => FakeClient(FakeRequest(FakeResponse(401, ''))));
  try { await rejected({'endpoint': 'https://example.invalid', 'refreshToken': 'secret'}); throw StateError('401 accepted'); }
  on AccessRejected { /* Device identity must remain stored. */ }
  final malformed = RelayTokenRefresh(clientFactory: () => FakeClient(FakeRequest(FakeResponse(200, '{}'))));
  try { await malformed({'endpoint': 'https://example.invalid', 'refreshToken': 'secret'}); throw StateError('invalid rotation accepted'); }
  on RefreshConsumed { /* 200 may already have consumed the old token. */ }
  final redirect = RelayTokenRefresh(clientFactory: () => FakeClient(FakeRequest(FakeResponse(302, ''))));
  try { await redirect({'endpoint': 'https://example.invalid', 'refreshToken': 'secret'}); throw StateError('redirect accepted'); }
  on HttpException { /* A refresh token must not follow redirects. */ }
  print('relay refresh contract passed');
}
