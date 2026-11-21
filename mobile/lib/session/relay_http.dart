import 'dart:convert';
import 'dart:io';
import 'session_manager.dart';

class RelayApiException implements Exception {
  const RelayApiException(this.code, this.message, this.status);
  final String code, message;
  final int status;
  @override String toString() => message;
}
class RelayHttp {
  RelayHttp({HttpClient Function()? factory}) : factory = factory ?? HttpClient.new;
  final HttpClient Function() factory;
  Future<Map<String, dynamic>> json(String endpoint, String path, {String method = 'GET', Map<String, dynamic>? body, String? token, bool Function()? stillCurrent}) async {
    final base = Uri.tryParse(endpoint);
    if (base == null || base.scheme != 'https' || base.host.isEmpty || base.userInfo.isNotEmpty || base.hasQuery || base.hasFragment ||
        !path.startsWith('/api/')) {
      throw const FormatException('服务器地址无效');
    }
    final uri = Uri.parse('${base.toString().replaceFirst(RegExp(r'/+$'), '')}$path');
    final client = factory()..connectionTimeout = const Duration(seconds: 20);
    try {
      return await (() async {
        final request = await client.openUrl(method, uri); request.followRedirects = false;
        if (stillCurrent?.call() == false) throw SessionChanged();
        request.headers.set(HttpHeaders.acceptHeader, 'application/json');
        if (token != null) request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
        if (body != null) { request.headers.contentType = ContentType.json; request.write(jsonEncode(body)); }
        final response = await request.close(); final bytes = <int>[];
        await for (final chunk in response) { if (bytes.length + chunk.length > 1024 * 1024) throw const FormatException('服务器响应过大'); bytes.addAll(chunk); }
        final decoded = jsonDecode(utf8.decode(bytes));
        if (decoded is! Map<String, dynamic>) throw const FormatException('服务器响应格式无效');
        if (response.statusCode < 200 || response.statusCode >= 300) {
          final error = decoded['error'];
          throw RelayApiException(error is Map ? error['code'] as String? ?? 'HTTP_ERROR' : 'HTTP_ERROR',
            error is Map ? error['message'] as String? ?? '服务器请求失败' : '服务器请求失败', response.statusCode);
        }
        return decoded;
      })().timeout(const Duration(seconds: 40));
    } finally { client.close(force: true); }
  }
  Future<Map<String, dynamic>> authenticatedRead(SessionManager sessions, SessionRef ref, String path) => sessions.read(ref, (credentials) async {
    try { return await json(credentials['endpoint'] as String, path, token: credentials['accessToken'] as String); }
    on RelayApiException catch (error) { if (error.status == 401) throw AccessRejected(); rethrow; }
  });
}
